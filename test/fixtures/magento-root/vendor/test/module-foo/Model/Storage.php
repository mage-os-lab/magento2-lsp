<?php

namespace Test\Foo\Model;

use Test\Foo\Api\StorageInterface;

class Storage extends DataObject implements StorageInterface
{
    public function init(): void
    {
    }
}
